import { redirect } from 'next/navigation';

/** Orphan duplicate of /tos — kept as a redirect. */
export default function TermsRedirect() {
  redirect('/tos');
}
