import KeywordView from '@/components/KeywordView';

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ p?: string }> }) {
  return <KeywordView id={(await params).id} initialPlatform={(await searchParams).p} />;
}
