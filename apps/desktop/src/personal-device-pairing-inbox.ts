const defaultCapacity = 8;

export interface PersonalDevicePairingInbox {
  accept: (link: string) => void;
  consume: (expectedLink?: string) => string | null;
}

export const createPersonalDevicePairingInbox = (
  capacity = defaultCapacity
): PersonalDevicePairingInbox => {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError("Pairing inbox capacity must be a positive integer.");
  }
  const links: string[] = [];

  return {
    accept(link) {
      const existing = links.indexOf(link);
      if (existing >= 0) links.splice(existing, 1);
      links.push(link);
      if (links.length > capacity) links.splice(0, links.length - capacity);
    },
    consume(expectedLink) {
      if (expectedLink === undefined) return links.shift() ?? null;
      const index = links.indexOf(expectedLink);
      if (index < 0) return null;
      return links.splice(index, 1)[0] ?? null;
    }
  };
};
