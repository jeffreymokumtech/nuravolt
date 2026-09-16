const Category = ({ text }:{text:string}) => {
  return (
    <div
      className={`dark:text-black dark:bg-white bg-primary text-white text-xs font-inter font-medium w-fit px-2 py-1 rounded-md`}
    >
      {text}
    </div>
  );
};

export default Category;
