import type { ReactNode } from "react";

export function PageFrame({ title, description, children, className = "" }: {
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`page-frame ${className}`}>
      <div className="breadcrumb">
        Workspace <span aria-hidden="true">/</span> <span>{title}</span>
      </div>
      <header className="page-heading">
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {children}
    </div>
  );
}
