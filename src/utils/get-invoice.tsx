import html2canvas from "html2canvas";
import jsPDF from "jspdf";

const downloadAsPDF = () => {
  const content = document.getElementById("invoice-modal");
  const stripeName = "Dennis";
  if (content) {
    html2canvas(content).then((canvas) => {
      const imgData = canvas.toDataURL("image/png");
      const pdfWidth = 150;
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      const pdf = new jsPDF("p", "mm", "a4");
      pdf.addImage(imgData, "PNG", 0, 0, pdfWidth, pdfHeight);
      pdf.save(stripeName + " Invoice.pdf");
    });
  }
};
