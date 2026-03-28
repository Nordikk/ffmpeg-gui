type SectionTitleProps = {
  eyebrow: string;
  title: string;
  body: string;
};

export function SectionTitle({ eyebrow, title, body }: SectionTitleProps) {
  return (
    <div className="section-title">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}
