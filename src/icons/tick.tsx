const Tick = ({ width = 19, height = 10 }) => {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 21 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M10.8924 18.7292C15.4847 18.7292 19.2076 15.0063 19.2076 10.414C19.2076 5.8216 15.4847 2.09875 10.8924 2.09875C6.3 2.09875 2.57715 5.8216 2.57715 10.414C2.57715 15.0063 6.3 18.7292 10.8924 18.7292Z"
        stroke="#1AAB12"
        strokeWidth="1.66304"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.39746 10.4133L10.0605 12.0763L13.3866 8.75024"
        stroke="#1AAB12"
        strokeWidth="1.66304"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default Tick;
