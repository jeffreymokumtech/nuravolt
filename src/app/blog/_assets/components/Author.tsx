import {FC} from "react";

interface AuthorAvatarProps {
    post: WPDetailedPost;
}

const AuthorAvatar: FC<AuthorAvatarProps> = ({ post }) => {
    const { yoast_head_json } = post;

    const authorSchema = yoast_head_json?.schema?.["@graph"]?.find(
        (item) => item["@type"] === "Person"
    );

    const authorName = authorSchema?.name || 'Unknown Author';
    const avatarUrl = authorSchema?.image?.contentUrl || '';

    return (
        <div className="author-avatar">
            {avatarUrl && (
                <img src={avatarUrl} alt={authorName} className="avatar-image" width={48} height={48} />
            )}
            <p className="author-name">{authorName}</p>
        </div>
    );
};

export default AuthorAvatar;