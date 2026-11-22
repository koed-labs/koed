export function subscribeToMainWindowFocus(
  listener: (focused: boolean) => void,
  read: () => Promise<unknown>,
  listen: (receive: (focused: unknown) => void) => () => void
): () => void {
  let subscribed = true;
  let initial = true;
  const receive = (focused: unknown) => {
    if (!subscribed || typeof focused !== "boolean") return;
    initial = false;
    listener(focused);
  };
  const unsubscribe = listen(receive);
  void read().then(
    (focused) => {
      if (initial) receive(focused);
    },
    () => {}
  );
  return () => {
    subscribed = false;
    unsubscribe();
  };
}
