import CompanyInsights from '@/components/CompanyInsights';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <CompanyInsights id={Number((await params).id) || 0} />;
}
