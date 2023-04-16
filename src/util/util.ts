export const getNowMsec = () => {
  return Date.now();
};

export const getNowSec = () => {
  return Math.floor(getNowMsec() / 1000);
};

export const log = (msg: string) => {
  console.log(`[${new Date().toISOString()}] ${msg}`);
};

export const delay = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

export const uniq = <T>(arr: T[]) => {
  return [...new Set(arr)];
};
