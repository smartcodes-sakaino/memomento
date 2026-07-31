/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Cloudflare Pages では Next.js の画像最適化サーバーが使えないため無効化する
    unoptimized: true,
  },
};

export default nextConfig;
