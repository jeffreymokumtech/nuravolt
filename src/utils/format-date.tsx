const FormatDate = (dateString: string) => {
  const date = new Date(Date.parse(dateString));
  if (isNaN(date.getTime())) {
    return "Invalid Dates";
  }
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
  };
  return date.toLocaleDateString("en-US", options);
};

export default FormatDate;
