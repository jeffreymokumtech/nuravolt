import toast from "react-hot-toast";

export async function validateGithubUsername(username: string) {
  const res = await fetch(`https://api.github.com/users/${username}`);

  if (!res.ok) {
    // throw Error(errorData?.error?.message || "An error occurred");
    return "Not Found";
  }

  const repo = await res.json();
  return repo;
}
