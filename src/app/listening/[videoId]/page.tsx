import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ videoId: string }>;
}

// The separate light-themed Listening Practice page has been retired in
// favor of the shared dark practice page (see /dictation/[videoId]) with
// Listening Mode as an inline mode switch. This route stays only so old
// bookmarks/links keep working, by redirecting straight to that shared page.
export default async function ListeningRedirectPage({ params }: PageProps) {
  const { videoId } = await params;
  redirect(`/dictation/${videoId}?mode=listening`);
}
