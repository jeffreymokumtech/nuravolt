export const convertToReadableDate = (dateString: any) => {
  const date = new Date(dateString);
  const options: any = { year: "numeric", month: "short", day: "2-digit" };
  return new Intl.DateTimeFormat("en-US", options).format(date);
};
