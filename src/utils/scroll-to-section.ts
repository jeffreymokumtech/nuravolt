export const ScrollToSection = (sectionId: string) => {
  const section = document.getElementById(sectionId);

  if (section) {
    setTimeout(() => {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 200); // Delay to wait for layout shifts
  }
};
