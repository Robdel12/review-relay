const $ = (id) => document.getElementById(id);
const activity = {
  comment: 'Inline feedback',
  review: 'New review',
  changes: 'Changes requested',
  requested: 'Review requested',
  merged: 'Pull request merged',
  closed: 'Pull request closed',
};
const dates = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const linkRole = { author: 'Author', reviewer: 'Reviewer' };
const emptyLinks = {
  all: 'No linked pull requests.',
  reviewer: 'No linked PRs to review.',
  author: 'No linked PRs you authored.',
};
const statusLabels = {
  pending: 'Waiting',
  queued: 'Queued in Codex',
  delivered: 'Handed to Claude Code',
  failed: 'Failed',
  skipped: 'Skipped',
  archived: 'Archived',
  stopped: 'Stopped',
  merged: 'Merged',
  closed: 'Closed',
};

function node(tag, name, content) {
  const element = document.createElement(tag);
  if (name) element.className = name;
  if (content) element.textContent = content;
  return element;
}

function anchor(url, content, name) {
  const element = node('a', name, content);
  element.href = url;
  return element;
}

function resumeButton(link, label, style) {
  const button = node('button', style, label);
  button.type = 'button';
  button.setAttribute('aria-label', `Copy Claude Code resume command for PR #${link.number}`);
  button.addEventListener('click', async () => {
    const command = `claude --resume ${link.thread}`;
    try {
      await navigator.clipboard.writeText(command);
      toast('Resume command copied.');
    } catch {
      toast(command);
    }
  });
  return button;
}

async function save(path, data) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? result.error);
  return result;
}

let toastTimer;
function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 4500);
}

function row(link) {
  const line = node('article', 'pr-row');
  const title = node('div');
  title.append(
    anchor(
      `https://github.com/${link.repo}/pull/${link.number}`,
      link.title || `Pull request #${link.number}`,
      'pr-title',
    ),
  );
  const metadata = node('div', 'meta');
  metadata.append(
    node('span', 'pr-number', `#${link.number}`),
    node('span', null, link.repo),
    node('span', 'pr-role', linkRole[link.role]),
  );
  if (link.status !== 'open') metadata.append(node('span', null, statusLabels[link.status]));
  else if (state.delivery.mode === 'push' && !link.subscribed)
    metadata.append(node('span', null, 'Waiting for relay'));
  title.append(metadata);
  const actions = node('div', 'pr-options');
  if (link.provider === 'claude')
    actions.append(resumeButton(link, 'Copy resume command', 'chat-link'));
  else {
    const chat = anchor(`codex://threads/${link.thread}`, 'Open chat', 'chat-link');
    chat.setAttribute('aria-label', `Open chat for PR #${link.number}`);
    actions.append(chat);
  }
  if (link.status === 'open') {
    const stop = node('button', 'stop', 'Stop');
    stop.type = 'button';
    stop.setAttribute('aria-label', `Stop watching PR #${link.number}`);
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      try {
        await save(`/api/links/${link.id}`, {});
        toast(`Stopped watching #${link.number}.`);
      } catch (error) {
        stop.disabled = false;
        toast(error.message);
      }
    });
    actions.append(stop);
  }
  line.append(title, actions);
  return line;
}

function eventRow(event) {
  const line = node('article', 'activity-line');
  line.dataset.status = event.status;
  const claude = event.provider === 'claude';
  line.append(
    claude
      ? resumeButton(event, activity[event.kind], 'text-button event-label')
      : anchor(`codex://threads/${event.thread}`, activity[event.kind], 'event-label'),
  );
  let status = statusLabels[event.status] ?? event.status;
  if (event.status === 'pending') {
    status = claude ? 'Waiting for Claude Code' : event.sentAt ? 'Requeueing' : 'Waiting';
  }
  const metadata = node('div', 'meta');
  const statusText = node('span', null, status);
  if (event.sentAt) statusText.title = `Last sent ${dates.format(event.sentAt)}`;
  metadata.append(
    node('span', null, `#${event.number} · ${dates.format(event.received)} ·`),
    statusText,
  );
  if (event.canRetry) {
    const label = event.status === 'failed' ? 'Retry' : 'Requeue';
    const retry = node('button', 'text-button', label);
    retry.type = 'button';
    retry.setAttribute(
      'aria-label',
      `${label} ${activity[event.kind].toLowerCase()} for PR #${event.number}`,
    );
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      try {
        await save(`/api/retry/${event.id}`, { status: event.status, sentAt: event.sentAt });
        toast(`Delivery requested for #${event.number}.`);
      } catch (error) {
        retry.disabled = false;
        toast(error.message);
      }
    });
    metadata.append(retry);
  }
  line.append(metadata);
  return line;
}

let state;
const roleFilters = $('role-filters');
function renderLinks(links) {
  const role = roleFilters.querySelector('input:checked').value;
  const visible = role === 'all' ? links : links.filter((link) => link.role === role);
  const live = visible.filter((link) => link.status === 'open');
  const archived = visible.filter((link) => link.status !== 'open');
  $('active-count').textContent = live.length;
  $('archive-count').textContent = archived.length;
  $('archive').hidden = !archived.length;
  $('links').replaceChildren(
    ...(live.length ? live.map(row) : [node('p', 'empty', emptyLinks[role])]),
  );
  $('archived-links').replaceChildren(...archived.map(row));
}

roleFilters.addEventListener('change', () => {
  if (state) renderLinks(state.links);
});

function render(data) {
  const { links, events, relay, delivery } = data;
  const linksChanged =
    state?.delivery.mode !== delivery.mode ||
    JSON.stringify(state?.links) !== JSON.stringify(links);
  const eventsChanged = JSON.stringify(state?.events) !== JSON.stringify(events);
  state = data;
  const polling = delivery.mode === 'polling';
  if (linksChanged) renderLinks(links);
  if (eventsChanged) {
    $('events').replaceChildren(
      ...(events.length ? events.map(eventRow) : [node('p', 'empty', 'No deliveries yet.')]),
    );
  }

  const labels = {
    unpaired: 'Relay not paired',
    connecting: 'Connecting',
    offline: 'Relay offline',
    connected: 'Relay connected',
  };
  const status = polling
    ? delivery.error
      ? 'GitHub check failed'
      : `Polling · ${Math.round(delivery.interval / 60000)} min`
    : labels[relay.status] || 'Checking relay';
  const control = $('settings-control');
  control.dataset.live = polling ? !delivery.error : relay.status === 'connected';
  control.setAttribute('aria-label', `Settings. ${status}`);
  control.title =
    polling && delivery.lastPoll ? `Last check ${dates.format(delivery.lastPoll)}` : 'Settings';
  $('relay-label').textContent = status;

  const message = polling
    ? delivery.error
      ? 'Check your gh login. Review Relay will retry.'
      : ''
    : relay.status === 'unpaired'
      ? 'Pair a Cloudflare relay to receive GitHub events.'
      : relay.status === 'offline'
        ? 'The relay will reconnect automatically.'
        : relay.status === 'connected' && !relay.lastWebhook
          ? 'Waiting for the first signed GitHub delivery.'
          : relay.status === 'connected' &&
              links.some((link) => link.status === 'open' && link.repo !== relay.repo)
            ? 'Some PRs belong to a repository outside this relay.'
            : '';
  $('setup').hidden = !message;
  $('setup-action').hidden = polling;
  if ($('setup-copy').textContent !== message) $('setup-copy').textContent = message;
}

$('new-link').addEventListener('click', () => $('link-dialog').showModal());
function openSettings(showRelay = false) {
  $('poll-minutes').value = state ? Math.round(state.delivery.interval / 60000) : '';
  $('relay-form').elements.url.value = state?.relay.url ?? '';
  $('relay-options').open = showRelay;
  $('settings-dialog').showModal();
}
$('settings-control').addEventListener('click', () => openSettings());
$('setup-action').addEventListener('click', () => {
  openSettings(true);
  $('relay-form').elements.url.focus();
});
for (const button of document.querySelectorAll('[data-close]'))
  button.addEventListener('click', () => button.closest('dialog').close());

function form(id, target, message, values = (form) => Object.fromEntries(new FormData(form))) {
  const form = $(id);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    const feedback = form.querySelector('.error');
    feedback.textContent = '';
    button.disabled = true;
    try {
      await save(target, values(form));
      form.reset();
      if (id === 'link-form') $('link-options').open = false;
      form.closest('dialog').close();
      toast(message);
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
form('link-form', '/api/links', 'Pull request linked.');
form('poll-form', '/api/polling', 'Polling interval saved.', (form) => ({
  minutes: form.elements.minutes.valueAsNumber,
}));
form('relay-form', '/api/pair', 'Connecting to the relay.');
const stream = new EventSource('/stream');
stream.onmessage = (event) => render(JSON.parse(event.data));
stream.onerror = () => {
  $('settings-control').dataset.live = false;
  $('settings-control').setAttribute('aria-label', 'Settings. Local app disconnected');
  $('relay-label').textContent = 'Local app disconnected';
};
