import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Academic Sales CRM',
  description: 'Multi-brand academic course sales and admission CRM',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
