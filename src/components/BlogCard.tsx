"use client";
import React, { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { posts } from "@/utils/data";

const BlogCard = () => {
  const [visiblePosts, setVisiblePosts] = useState(6);

  const loadMore = () => {
    setVisiblePosts((prevVisiblePosts) => prevVisiblePosts + 6);
  };
  return (
    <div className="mt-[100px] mb-[40px]">
      <div className="container mx-auto p-8 px-20  md:w-[80%] ">
        <h1 className="text-4xl font-bold text-center mb-14">
          The MyNew App Blog
        </h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 ">
          {posts.slice(0, visiblePosts).map((post, index) => (
            <Link
              href={`/blog/${post.slug}`}
              key={index}
              className="bg-paper  dark:bg-[#1E232C] rounded overflow-hidden shadow-sm dark:border border-solid border-[#373C53] hover:border-[#5b6285] transition-all duration-500 transform hover:scale-105 ease-in-out  "
            >
              <Image
                src={post.image}
                alt={post.alt}
                className="object-cover"
                width={500}
                height={156}
              />
              <div className="p-4">
                <h2 className=" font-normal text-[16px] dark:text-white mb-2">
                  {post.title}
                </h2>
                <p className="text-ink-3">{post.date}</p>
              </div>
            </Link>
          ))}
        </div>
        {visiblePosts < posts.length && (
          <div className="flex justify-center">
            <button
              className="bg-[#1364FF] w-32 rounded-lg text-white font-semibold py-3 mt-12"
              onClick={loadMore}
            >
              See more
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default BlogCard;
