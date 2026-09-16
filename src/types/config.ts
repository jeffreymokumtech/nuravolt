export type Theme =
  | "light"
  | "dark"
  | "cupcake"
  | "bumblebee"
  | "emerald"
  | "corporate"
  | "synthwave"
  | "retro"
  | "cyberpunk"
  | "valentine"
  | "halloween"
  | "garden"
  | "forest"
  | "aqua"
  | "lofi"
  | "pastel"
  | "fantasy"
  | "wireframe"
  | "black"
  | "luxury"
  | "dracula"
  | "";

export interface ConfigProps {
  appName: string;
  appDescription: string;
  domainName: string;
  stripe: {
    products: StripeProduct[];
  };
  colors: {
    theme: Theme;
    main: string;
  };
  resend: {
    fromAdmin: string;
    supportEmail?: string;
    forwardRepliesTo?: string;
    subjects?: {
      [key: string]: string
    }
  };
}
