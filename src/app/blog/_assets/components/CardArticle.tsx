import type {FC, JSX} from "react";
import Link from "next/link";
import Image from "next/image";
import Avatar from "./Avatar";
import { Card, CardContent, CardHeader } from "@/components/ui/card";



interface  CardArticleProps {
  article: WPPostListItem,
  isImagePriority?: boolean;
}

const CardArticle: FC<CardArticleProps> = ({
  article, isImagePriority
}) => {

  return (
    <Card className="card bg-[#141414] rounded-box overflow-hidden">
      `
      {article?.title?.rendered && (
        <CardHeader>
          <Link
            href={`/blog/${article?.slug}`}
            className="link link-hover hover:link-primary"
            title={article.title.rendered}
            rel="bookmark"
          >
            <figure>
              {!!article.image_url.length &&
                  <Image
                      src={article.image_url}
                      alt={'asfwefcwedf'}
                      width={600}
                      height={338}
                      priority={isImagePriority}
                      className="aspect-video object-center object-cover hover:scale-[1.03] duration-200 ease-in-out"
                  />
              }

            </figure>
          </Link>
        </CardHeader>
      )}

      <CardContent className="card-body">

        <h2 className="mb-1 text-xl md:text-2xl font-bold text-white hover:text-white">
          <Link
            href={`/blog/${article.slug}`}
            className="link link-hover hover:text-white"
            title={article?.title?.rendered || ''}
            rel="bookmark"
          >
            {article.title.rendered}
          </Link>
        </h2>

        <div className=" text-base-content/80 space-y-4">


          {!!article?.date &&
              <div className="flex items-center gap-4 text-sm text-white">
                <span itemProp="datePublished">
              {new Date(article?.date).toLocaleDateString(
                  "en-US",
                  {
                    month: "long",
                    day: "numeric",
                  }
              )}
            </span>
              </div>
          }

        </div>
      </CardContent>
    </Card>
  );
};

export default CardArticle;
