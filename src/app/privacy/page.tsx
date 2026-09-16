import { redirect } from 'next/navigation';

/** Orphan duplicate of /privacy-policy — kept as a redirect. */
export default function PrivacyRedirect() {
  redirect('/privacy-policy');
}
