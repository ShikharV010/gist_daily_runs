import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const vertGrotesk = localFont({
  src: "./fonts/VertGrotesk.ttf",
  variable: "--font-vert-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "In-House Cold Email Insights",
  description: "Gushwork cold email performance dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${vertGrotesk.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
