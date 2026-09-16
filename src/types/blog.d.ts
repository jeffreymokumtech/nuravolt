interface WPPost {
  id: number;
  slug: string;
  title: {
    rendered: string;
  };
  featured_media: number;
  date: string;
  author: number;
}

interface WPPostListItem extends WPPost {
  image_url: string;
}

interface WPDetailedPost {
  html: string;
  id: number;
  date: string;
  date_gmt: string;
  guid: {
    rendered: string;
  };
  modified: string;
  modified_gmt: string;
  slug: string;
  status: string;
  type: string;
  link: string;
  title: {
    rendered: string;
  };
  content: {
    rendered: string;
    protected: boolean;
  };
  excerpt: {
    rendered: string;
    protected: boolean;
  };
  author: number;
  featured_media: number;
  comment_status: string;
  ping_status: string;
  sticky: boolean;
  template: string;
  format: string;
  meta: {
    footnotes: string;
  };
  categories: number[];
  tags: any[];
  class_list: string[];
  yoast_head: string;
  yoast_head_json: YoastHeadJson;
  _links: Links;
}

interface YoastHeadJson {
  title: string;
  robots: {
    index: string;
    follow: string;
    maxSnippet: string;
    maxImagePreview: string;
    maxVideoPreview: string;
  };
  canonical: string;
  og_locale: string;
  og_type: string;
  og_title: string;
  og_description: string;
  og_url: string;
  og_site_name: string;
  article_published_time: string;
  article_modified_time: string;
  og_image: OgImage[];
  author: string;
  twitter_card: string;
  twitter_misc: {
    "Written by": string;
    "Est. reading time": string;
  };
  schema: {
    "@context": string;
    "@graph": SchemaGraph[];
  };
}

interface OgImage {
  width: number;
  height: number;
  url: string;
  type: string;
}

interface SchemaGraph {
  "@type": string | string[];
  "@id": string;
  isPartOf?: {
    "@id": string;
  };
  author?: {
    name: string;
    "@id": string;
  };
  headline?: string;
  datePublished?: string;
  dateModified?: string;
  mainEntityOfPage?: {
    "@id": string;
  };
  wordCount?: number;
  publisher?: {
    "@id": string;
  };
  image?: {
    contentUrl?: string;
    "@id": string;
  };
  thumbnailUrl?: string;
  inLanguage?: string;
  url?: string;
  name?: string;
  breadcrumb?: {
    "@id": string;
  };
  mainEntity?: {
    "@id": string;
  }[];
  potentialAction?: {
    "@type": string;
    target: string[];
  }[];
  position?: number;
  answerCount?: number;
  acceptedAnswer?: {
    "@type": string;
    text: string;
    inLanguage: string;
  };
  caption?: string;
  itemListElement?: {
    "@type": string;
    position: number;
    name: string;
    item: string;
  }[];
}

interface Links {
  self: Link[];
  collection: Link[];
  about: Link[];
  author: Link[];
  replies: Link[];
  "version-history": VersionHistory[];
  "predecessor-version"?: {
    id: number;
    href: string;
  };
  "wp:featuredmedia": Link[];
  "wp:attachment": Link[];
  "wp:term": WpTerm[];
  curies: Cury[];
}

interface Link {
  href: string;
  embeddable?: boolean;
}

interface VersionHistory {
  count: number;
  href: string;
}

interface WpTerm {
  taxonomy: string;
  embeddable: boolean;
  href: string;
}

interface Cury {
  name: string;
  href: string;
  templated: boolean;
}
