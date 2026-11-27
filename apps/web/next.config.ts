import type { NextConfig } from 'next';

const api = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  // The browser talks only to this origin; /api/v1/* is proxied to the API so auth
  // cookies stay first-party and no CORS is ever enabled on the API.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` }];
  },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
