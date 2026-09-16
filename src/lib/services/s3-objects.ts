import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Generic S3 object helpers for document blobs (contract PDFs, audit report
 * PDFs). The parquet-oriented lake writer lives in s3-storage.ts; this is the
 * small put/get/presign surface the app layer needs. Bucket defaults to the
 * lake bucket (nuravolt-lake-rw key has rw on it).
 */

const REGION = process.env.AWS_REGION || 'eu-west-1';
const BUCKET = process.env.LAKE_BUCKET || 'nuravolt-lake';

let _client: S3Client | null = null;
function client(): S3Client {
  if (!_client) _client = new S3Client({ region: REGION });
  return _client;
}

export function objectBucket(): string {
  return BUCKET;
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await client().send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

/** Short-lived download URL (default 5 minutes). */
export async function presignGetObject(
  key: string,
  opts: { expiresInSeconds?: number; downloadFilename?: string } = {},
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ...(opts.downloadFilename
      ? { ResponseContentDisposition: `attachment; filename="${opts.downloadFilename}"` }
      : {}),
  });
  // Cast: client-s3@3.700 and the presigner disagree on smithy generic
  // params because other @aws-sdk packages in the tree are newer; the
  // runtime contract is identical.
  return getSignedUrl(
    client() as unknown as Parameters<typeof getSignedUrl>[0],
    command,
    { expiresIn: opts.expiresInSeconds ?? 300 },
  );
}
