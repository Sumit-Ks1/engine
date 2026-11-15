import Dashboard from '@/components/Dashboard';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <Dashboard companyId={(await params).id} />;
}
