import KeywordView from '@/components/KeywordView';

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ p?: string; c?: string }> }) {
  const q = await searchParams;
  return <KeywordView id={(await params).id} initialPlatform={q.p} companyId={/^\d+$/.test(q.c ?? '') ? q.c : undefined} />;
}
