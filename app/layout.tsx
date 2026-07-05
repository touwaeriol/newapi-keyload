import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "供应商 Key 上渠道系统",
  description: "本地全栈 · 密钥登录 · 自动创建/更新 Anthropic Claude 渠道",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
