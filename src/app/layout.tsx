import type { Metadata } from "next";
import { Epilogue, Plus_Jakarta_Sans, Zen_Maru_Gothic } from "next/font/google";
import "./globals.css";

const epilogue = Epilogue({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-heading",
});

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-body",
});

const zenMaru = Zen_Maru_Gothic({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-jp",
  preload: false,
});

export const metadata: Metadata = {
  title: "Memomento — 日々の小さな瞬間をメモに",
  description: "個人用のメモ・学習ノートアプリ",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body
        className={`${epilogue.variable} ${jakarta.variable} ${zenMaru.variable}`}
      >
        {children}
      </body>
    </html>
  );
}
