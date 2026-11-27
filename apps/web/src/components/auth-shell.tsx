export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-sm font-semibold tracking-wide text-brand-700">
          ACADEMIC SALES CRM
        </p>
        <div className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h1 className="mb-4 text-lg font-semibold">{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}
