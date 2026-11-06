/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Type errors must fail the build (tsc --noEmit is clean as of Phase 12).
    ignoreBuildErrors: false,
  },
};

export default nextConfig;