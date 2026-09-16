export async function getData(endpoint: string) {
  const res = await fetch(process.env.NEXT_PUBLIC_STRAPI_BASE_URL + endpoint, {
    headers: {
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_STRAPI_API_TOKEN}`,
    },
    cache: "no-cache",
  });

  // The return value is *not* serialized
  // You can return Date, Map, Set, etc.

  if (!res.ok) {
    // This will activate the closest `error.js` Error Boundary

    throw new Error("Failed to fetch data");
  }

  return res.json();
}
