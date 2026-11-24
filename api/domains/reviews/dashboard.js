const encode = new TextEncoder();

export function createDashboard(onError) {
  const subscribers = new Set();

  function frame(view) {
    return encode.encode(`data: ${JSON.stringify(view)}\n\n`);
  }

  return Object.freeze({
    subscribe(view) {
      let subscriber;
      return new ReadableStream(
        {
          async start(controller) {
            subscriber = controller;
            subscribers.add(controller);
            try {
              const initial = await view();
              if (subscribers.has(controller)) controller.enqueue(frame(initial));
            } catch (error) {
              if (subscribers.delete(controller)) controller.error(error);
            }
          },
          cancel() {
            subscribers.delete(subscriber);
          },
        },
        { highWaterMark: 8 },
      );
    },
    async publish(view) {
      if (subscribers.size === 0) return;
      try {
        const update = frame(await view());
        for (const controller of subscribers) {
          if (controller.desiredSize > 0) controller.enqueue(update);
          else {
            subscribers.delete(controller);
            controller.close();
          }
        }
      } catch (error) {
        onError(error);
      }
    },
  });
}
