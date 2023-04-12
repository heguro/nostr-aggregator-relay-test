export const getNowMsec = () => {
  return Date.now();
};

export const getNowSec = () => {
  return Math.floor(getNowMsec() / 1000);
};
