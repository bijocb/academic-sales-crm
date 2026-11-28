import { Banner } from './ui';

export function OfflineBanner({ stale, savedAt }: { stale: boolean; savedAt?: string }) {
  if (!stale) return null;
  const at = savedAt ? new Date(savedAt).toLocaleString() : 'earlier';
  return (
    <Banner>
      Offline — showing the copy saved {at}. Logging calls and sending messages need a connection.
    </Banner>
  );
}
