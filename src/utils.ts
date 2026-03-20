export const nowIso = (): string => new Date().toISOString();

export const sleep = async (ms = 0): Promise<void> => {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const randomId = (prefix: string): string => {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${random}`;
};
