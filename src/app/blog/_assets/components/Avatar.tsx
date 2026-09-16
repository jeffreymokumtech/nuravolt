import Link from "next/link";
// import Image from "next/image";
import { Avatar as ShadeCnAvatar, AvatarImage } from "@/components/ui/avatar";
import {FC} from "react";
// This is the author avatar that appears in the article page and in <CardArticle /> component

interface BlogAvatarProps {
  author: any
}

const Avatar: FC<BlogAvatarProps> = ({author}) => {
  return (
      <div className="inline-flex items-center gap-2 group">
      <span itemProp="author">
        {author?.image?.url && (
            <img
              src={author?.image?.url}
              alt={'avatr'}
              width={40}
              height={40}
              className='w-[40px] h-[40px] rounded-full'
            />
                // <ShadeCnAvatar>
                //   <AvatarImage
                //       src={author?.image?.url}
                //       alt="profile-pic"
                //   />
                // </ShadeCnAvatar>
            )}
      </span>

  <span className="group-hover:underline text-white">
        {author?.displayName}
      </span>
      </div>

)
  ;
};

export default Avatar;
