import { z } from '@robdel12/cricket';
import { defineJob, state } from '@robdel12/cricket/jobs';

const queue = Object.freeze({ name: 'review-relay' });
const input = z.strictObject({});

export const pollReviews = defineJob({
  name: 'reviews.poll',
  input,
  queue,
  state: state.derived({ from: ['links', 'settings'] }),
  run: ({ services }) => services.reviews.poll(),
});

export const dispatchFeedback = defineJob({
  name: 'reviews.deliver',
  input,
  queue,
  state: state.derived({ from: ['events', 'links'] }),
  run: ({ services }) => services.reviews.deliver(),
});
