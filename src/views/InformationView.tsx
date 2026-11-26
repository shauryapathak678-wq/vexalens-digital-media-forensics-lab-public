import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  Archive,
  AudioLines,
  BrainCircuit,
  Braces,
  CircleAlert,
  Code2,
  Cpu,
  Eye,
  FileCheck2,
  FileSearch,
  FileText,
  Fingerprint,
  GitCompareArrows,
  Image as ImageIcon,
  Layers3,
  Network,
  ScanFace,
  ScanSearch,
  Server,
  ShieldCheck,
  Video,
  Linkedin,
} from 'lucide-react';
import './InformationView.css';
import { BrandLogo } from '@/components/BrandLogo';
import originalSample from '@/assets/images/evidence_sample_portrait_original_1792052939398.jpg';
import analyzedSample from '@/assets/images/evidence_sample_portrait_deepfake_1792052935476.jpg';

interface InformationViewProps {
  onHome: () => void;
  onOpenWorkspace: () => void;
  onOpenPrivacy: () => void;
}

const principles = [
  {
    number: '01',
    title: 'Evidence over assumption',
    description: 'Show observable details and keep interpretation separate from measured evidence.',
    icon: Eye,
    accent: 'cyan',
  },
  {
    number: '02',
    title: 'AI is a witness, not a judge',
    description: 'Model outputs can guide review, but are never presented as definitive proof.',
    icon: BrainCircuit,
    accent: 'violet',
  },
  {
    number: '03',
    title: 'Originals stay untouched',
    description: 'Preserve source files while recording hashes, metadata, and derived analysis separately.',
    icon: Fingerprint,
    accent: 'cyan',
  },
  {
    number: '04',
    title: 'Limitations stay visible',
    description: 'Explain what a result can indicate—and what it cannot establish.',
    icon: CircleAlert,
    accent: 'amber',
  },
  {
    number: '05',
    title: 'Investigator in control',
    description: 'The investigator reviews context, weighs alternatives, and makes the final interpretation.',
    icon: ScanSearch,
    accent: 'cyan',
  },
];

const analysisTools = [
  { title: 'Image Forensics', text: 'Inspect image metadata, compression differences, and visual indicators.', icon: ImageIcon },
  { title: 'Metadata Inspector', text: 'Inspect metadata available from supported evidence files.', icon: FileSearch },
  { title: 'Video Forensics', text: 'Review video evidence and inspect extracted frames.', icon: Video },
  { title: 'Audio Forensics', text: 'Examine audio signals and supported authenticity indicators.', icon: AudioLines },
  { title: 'Documents & Screenshots', text: 'Intake supported documents and inspect available file metadata.', icon: FileText },
  { title: 'Signature Comparison', text: 'Compare signature samples as an investigative aid.', icon: Fingerprint },
  { title: 'AI Image Detection', text: 'Review cautious, image-visible observations from a Puter vision model. Visual appearance alone cannot prove origin.', icon: BrainCircuit },
  { title: 'Deepfake Detection', text: 'Analyze supported media for potential synthetic or altered content.', icon: ScanFace },
  { title: 'Lip-Sync Investigation', text: 'Examine audio and video timing relationships.', icon: AudioLines },
  { title: 'Photo–Video Match', text: 'Compare a still image against video frames.', icon: GitCompareArrows },
  { title: 'Media Comparison', text: 'Compare evidence items side by side.', icon: Layers3 },
  { title: 'Origin Intelligence', text: 'Review available provenance and source context.', icon: Network },
  { title: 'Batch Investigation', text: 'Run supported analysis workflows across multiple items.', icon: Archive },
];

const projectStack = [
  { name: 'React', detail: 'User interface', icon: Braces },
  { name: 'TypeScript', detail: 'Application code', icon: Code2 },
  { name: 'Vite', detail: 'Frontend build', icon: Cpu },
  { name: 'Tailwind CSS', detail: 'Utility styling', icon: Layers3 },
  { name: 'Supabase', detail: 'Auth and data sync', icon: Server },
  { name: 'Express', detail: 'Server routes', icon: Network },
  { name: 'Google GenAI SDK', detail: 'AI-assisted analysis', icon: BrainCircuit },
  { name: 'ExifReader', detail: 'Metadata extraction', icon: FileSearch },
  { name: 'jsPDF', detail: 'PDF report export', icon: FileText },
];

const team = [
  {
    number: '01',
    department: 'Leadership & Development',
    name: 'Shaurya Pathak',
    role: 'Project Lead & Lead Developer',
    initials: 'SP',
    linkedin: 'https://www.linkedin.com/in/shaurya-pathak-783a87322',
    accent: 'cyan',
  },
  {
    number: '02',
    department: 'Research & Intelligence',
    name: 'Karishma Rastogi',
    role: 'Research Lead',
    initials: 'KR',
    linkedin: 'https://www.linkedin.com/in/karishma-rastogi-8a7ab53b1/',
    accent: 'violet',
  },
  {
    number: '03',
    department: 'Testing & Validation',
    name: 'Adarsh Singh',
    role: 'Forensic Testing & Validation Analyst',
    initials: 'AS',
    linkedin: 'https://www.linkedin.com/in/adarsh-singh-88154a353/',
    accent: 'blue',
  },
  {
    number: '04',
    department: 'Digital Evidence',
    name: 'Aisha Srivastava',
    role: 'Digital Evidence & Dataset Coordinator',
    initials: 'AS',
    linkedin: 'https://www.linkedin.com/in/aisha-srivastav-b189b139b/',
    accent: 'amber',
  },
];

const disclaimerPoints = [
  {
    label: 'AI Accuracy:',
    text: 'All analysis results, confidence scores, and detection reports are estimates generated by automated tools and may contain errors. Results should not be treated as conclusive proof of authenticity, manipulation, or criminal activity.',
  },
  {
    label: 'Evidence Verification:',
    text: 'Findings should be independently verified by qualified professionals before being used in legal proceedings, disciplinary actions, or other high-stakes decisions.',
  },
  {
    label: 'Source Tracking:',
    text: 'Any source links, account details, upload dates, or timestamps displayed by the platform depend on publicly available information and supported search services. Complete internet coverage and identification of the original creator or first uploader cannot be guaranteed.',
  },
  {
    label: 'Privacy and Data Protection:',
    text: 'Users must have appropriate authorization to upload, analyze, store, or share media containing personal or sensitive information.',
  },
  {
    label: 'Responsible Use:',
    text: 'This platform must not be used for harassment, impersonation, unauthorized surveillance, defamation, privacy violations, or any unlawful activity.',
  },
  {
    label: 'No Legal Certification:',
    text: 'VexaLens is an educational forensic assistance tool and does not replace certified forensic examination, expert testimony, or professional legal advice.',
  },
  {
    label: 'Limitation of Liability:',
    text: "The developers are not responsible for decisions, claims, or damages arising from the misuse or misinterpretation of the platform's results.",
  },
];

const sectionLinks = [
  { href: '#mission', label: 'Mission' },
  { href: '#analysis', label: 'What we analyze' },
  { href: '#purpose', label: 'How it works' },
  { href: '#technology', label: 'Technology' },
  { href: '#team', label: 'Core team' },
  { href: '#disclaimer', label: 'Disclaimer' },
];

export const InformationView: React.FC<InformationViewProps> = ({
  onHome,
  onOpenWorkspace,
  onOpenPrivacy,
}) => {
  const pageRef = useRef<HTMLElement>(null);
  const [selectedPrinciple, setSelectedPrinciple] = useState('01');
  const [comparePosition, setComparePosition] = useState(50);

  useEffect(() => {
    const page = pageRef.current;
    if (!page || !('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    page.classList.add('info-reveal-enabled');
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -32px 0px' },
    );

    page.querySelectorAll('[data-reveal]').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);


  return (
    <main className="information-page" id="information-page" ref={pageRef}>
      <header className="info-header">
        <button className="info-brand" type="button" onClick={onHome} aria-label="VexaLens home">
          <span className="info-brand-mark"><BrandLogo className="h-full w-full rounded-lg object-cover" /></span>
          <span className="info-brand-copy">
            <strong>VexaLens</strong>
            <small>Digital Media Forensics</small>
          </span>
        </button>
        <nav className="info-top-nav" aria-label="Information page">
          <a href="#information-page">About</a>
          <a href="#mission">Principles</a>
          <a href="#analysis">Tools</a>
          <a href="#team">The team</a>
          <button className="info-nav-cta" type="button" onClick={onOpenWorkspace}>
            Open workspace <ArrowRight aria-hidden="true" />
          </button>
        </nav>
      </header>

      <section className="info-hero" aria-labelledby="info-title">
        <div className="info-hero-grid" aria-hidden="true" />
        <div className="info-hero-copy">
          <p className="info-eyebrow"><span /> VEXALENS / THE STORY BEHIND THE LENS</p>
          <h1 id="info-title">Evidence hides in what the eye <em>can’t see.</em></h1>
          <p className="info-hero-description">
            VexaLens helps investigators examine digital files, understand analytical signals, and document what evidence can—and cannot—show.
          </p>
          <p className="info-hero-tagline">Every Pixel. Every Signal. Every Clue.</p>
          <div className="info-hero-actions">
            <a className="info-button info-button-primary" href="#mission">How we think <ArrowDown aria-hidden="true" /></a>
            <a className="info-button info-button-secondary" href="#analysis">Explore the tools <ArrowRight aria-hidden="true" /></a>
          </div>
        </div>
        <div className="evidence-visual" role="img" aria-label="Abstract connected evidence network">
          <div className="evidence-ring evidence-ring-outer" />
          <div className="evidence-ring evidence-ring-inner" />
          <div className="evidence-crosshair evidence-crosshair-horizontal" />
          <div className="evidence-crosshair evidence-crosshair-vertical" />
          <svg className="evidence-lines" viewBox="0 0 520 440" role="presentation">
            <path d="M86 110 206 176 315 86 423 168 356 309 204 340 86 266 206 176 356 309 423 168 315 86 204 340" />
            <path d="M86 110 86 266M206 176 204 340M315 86 356 309" />
          </svg>
          <span className="evidence-node node-a"><FileSearch /></span>
          <span className="evidence-node node-b"><Fingerprint /></span>
          <span className="evidence-node node-c"><AudioLines /></span>
          <span className="evidence-node node-d"><FileCheck2 /></span>
          <span className="evidence-node node-e"><ScanSearch /></span>
          <span className="evidence-hub"><ShieldCheck /></span>
          <span className="evidence-label label-a">SOURCE / 01</span>
          <span className="evidence-label label-b">TRACE / 02</span>
          <span className="evidence-label label-c">OBSERVATION</span>
          <span className="evidence-coordinates">EVIDENCE / LAYERS<br />OBSERVE · REVIEW · DOCUMENT</span>
        </div>
        <div className="info-hero-foot"><span>01 — A PLATFORM FOR CAREFUL EXAMINATION</span><span>INVESTIGATOR CONTROLLED</span></div>
      </section>

      <section className="info-problem" id="problem" aria-labelledby="problem-title">
        <div className="info-problem-copy" data-reveal>
          <p className="info-eyebrow">01 / THE CHALLENGE</p>
          <h2 id="problem-title">The visible file is only <em>one layer.</em></h2>
          <p>Images can be edited. Audio can be cloned. Documents can be altered. A file’s appearance alone rarely answers how it was made or changed.</p>
          <p>VexaLens brings supported examination tools and evidence context together, while leaving conclusions with the investigator.</p>
          <a className="info-inline-link" href="#analysis">See what the workspace examines <ArrowRight aria-hidden="true" /></a>
        </div>
        <div className="info-problem-demo" data-reveal>
          <div className="problem-demo-heading">
            <span>BUNDLED IMAGE COMPARISON</span>
            <span>DEMONSTRATION ONLY</span>
          </div>
          <div className="problem-sample" style={{ '--sample-reveal': `${comparePosition}%` } as React.CSSProperties}>
            <img src={originalSample} alt="Bundled sample portrait, first view" />
            <img className="problem-sample-layer" src={analyzedSample} alt="Bundled sample portrait, comparison view" />
            <span className="problem-lens" aria-hidden="true" />
            <span className="problem-sample-label sample-label-left">ORIGINAL SAMPLE</span>
            <span className="problem-sample-label sample-label-right">ALTERED SAMPLE</span>
          </div>
          <label className="problem-slider-label" htmlFor="about-sample-slider">Drag to compare bundled sample images</label>
          <input
            id="about-sample-slider"
            className="problem-slider"
            type="range"
            min="5"
            max="95"
            value={comparePosition}
            aria-valuetext={`Showing ${comparePosition}% of altered sample`}
            onChange={(event) => setComparePosition(Number(event.target.value))}
          />
          <p className="problem-demo-note">Illustrative bundled original and altered images—not case evidence, a heatmap, or an analysis result.</p>
        </div>
      </section>

      <section className="info-section info-purpose" id="purpose" aria-labelledby="purpose-title">
        <div className="info-section-heading" data-reveal>
          <p className="info-eyebrow">02 / HOW VEXALENS WORKS</p>
          <h2 id="purpose-title">Evidence in. Findings <em>in context.</em></h2>
          <p>VexaLens connects evidence intake, examination tools, recorded findings, and report preparation into one investigative workflow.</p>
          <p className="info-implementation-note">Capabilities depend on the file type and tools currently available in the application. Analytical outputs are indicators for investigation, not proof.</p>
        </div>
        <div className="purpose-flow purpose-pipeline" data-reveal>
          {[
            { number: '01', title: 'Evidence In', description: 'Add supported files to a case and preserve the original evidence context.', icon: FileSearch },
            { number: '02', title: 'Analysis', description: 'Use available examination tools to review file characteristics and signals.', icon: ScanSearch },
            { number: '03', title: 'Findings', description: 'Review observations, model output, meaning, and limitations in context.', icon: Eye },
            { number: '04', title: 'Report', description: 'Document supported findings and prepare reports for further review.', icon: FileCheck2 },
          ].map(({ number, title, description, icon: Icon }) => (
            <article className="purpose-step" key={number} data-reveal>
              <div className="purpose-step-top"><span>{number}</span><Icon aria-hidden="true" /></div>
              <h3>{title}</h3><p>{description}</p>
              <ArrowRight className="purpose-arrow" aria-hidden="true" />
            </article>
          ))}
        </div>
      </section>

      <section className="info-tools-section" id="analysis" aria-labelledby="analysis-title">
        <div className="info-section-heading" data-reveal>
          <p className="info-eyebrow">03 / WHAT WE ANALYZE</p>
          <h2 id="analysis-title">Purpose-built views for <em>different evidence.</em></h2>
          <p>These are the analysis modules currently represented in the application. Availability and output depend on the selected file and configured services.</p>
        </div>
        <div className="info-tools-grid">
          {analysisTools.map(({ title, text, icon: Icon }, index) => (
            <article className="info-tool-card" key={title} data-reveal>
              <span className="info-tool-index">{String(index + 1).padStart(2, '0')} / MODULE</span>
              <Icon aria-hidden="true" />
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
        <div className="info-workflow-modules" data-reveal>
          <p className="info-eyebrow">CASEWORK &amp; PLATFORM MODULES</p>
          <div className="info-module-list">
            {[
              'Evidence Intake', 'Batch Investigation', 'Case Management', 'Case Relationships',
              'Evidence Vault', 'Chain of Custody & Timeline', 'Certificates', 'Findings Register',
              'Reports & History Archive', 'Privacy & Sharing', 'Forensic Services',
              'AI Model Status', 'Backend Processing', 'Settings',
            ].map((module) => <span key={module}>{module}</span>)}
          </div>
        </div>
      </section>

      <section className="info-section info-mission" id="mission" aria-labelledby="mission-title">
        <div className="info-section-heading" data-reveal>
          <p className="info-eyebrow">04 / OUR PRINCIPLES</p>
          <h2 id="mission-title">Evidence first. <em>Interpretation second.</em></h2>
          <p>Our mission is to make digital forensic examination more accessible, transparent, and systematic by bringing evidence analysis, investigative observations, and understandable reporting into one platform.</p>
          <p>Select a principle to bring it forward. Each is a reminder that analysis supports careful human judgment; it does not replace it.</p>
        </div>
        <div className="principle-grid principle-stack">
          {principles.map(({ number, title, description, icon: Icon, accent }) => (
            <button
              type="button"
              className={`principle-card accent-${accent} ${selectedPrinciple === number ? 'is-selected' : ''}`}
              key={number}
              data-reveal
              aria-pressed={selectedPrinciple === number}
              onClick={() => setSelectedPrinciple(number)}
            >
              <div className="principle-card-top"><span>{number}</span><Icon aria-hidden="true" /></div>
              <h3>{title}</h3>
              <p>{description}</p>
              <span className="principle-line" />
            </button>
          ))}
        </div>
      </section>

      <section className="info-stack-section" id="technology" aria-labelledby="technology-title">
        <div className="info-section-heading" data-reveal>
          <p className="info-eyebrow">05 / TECHNOLOGY</p>
          <h2 id="technology-title">Built with the project’s <em>actual stack.</em></h2>
          <p>Technology listed here is drawn from the application’s package manifest and source imports.</p>
        </div>
        <div className="info-stack-grid">
          {projectStack.map(({ name, detail, icon: Icon }) => (
            <article className="info-stack-item" key={name} data-reveal>
              <Icon aria-hidden="true" />
              <div><h3>{name}</h3><p>{detail}</p></div>
            </article>
          ))}
        </div>
      </section>

      <section className="info-team" id="team" aria-labelledby="team-title">
        <div className="team-heading" data-reveal>
          <div className="team-heading-copy">
            <p className="info-eyebrow"><span /> VEXALENS / CORE TEAM</p>
            <h2 id="team-title">The people building <em>VexaLens.</em></h2>
            <p className="team-subtitle">Project contributors and their listed roles.</p>
          </div>
          <div className="team-logo-frame">
            <span className="team-logo-index">VXL / 04</span>
            <BrandLogo className="h-full w-full rounded-full object-cover" />
            <span className="team-logo-caption">DIGITAL EVIDENCE · HUMAN INSIGHT</span>
          </div>
        </div>
        <div className="team-grid">
          {team.map((member) => (
            <article className={`team-card team-${member.accent}`} key={member.number} data-reveal>
              <div className="team-card-meta"><span>{member.number}<i /></span><span>{member.department}</span></div>
              <div className="team-card-portrait">
                <span className="team-avatar" aria-hidden="true">{member.initials}</span>
                <span className="team-orbit" aria-hidden="true" />
              </div>
              <h3>{member.name}</h3>
              <p className="team-role">{member.role}</p>
              <a
                className="team-linkedin"
                href={member.linkedin}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${member.name} on LinkedIn (opens in a new tab)`}
              >
                <Linkedin aria-hidden="true" />
                <span>Connect on LinkedIn</span>
                <ArrowRight aria-hidden="true" />
              </a>
              <span className="team-card-rule" aria-hidden="true" />
            </article>
          ))}
        </div>
      </section>

      <section className="info-disclaimer" id="disclaimer" aria-labelledby="disclaimer-title">
        <div className="disclaimer-heading" data-reveal>
          <p className="info-eyebrow">07 / IMPORTANT INFORMATION</p>
          <h2 id="disclaimer-title">DISCLAIMER</h2>
        </div>
        <div className="disclaimer-panel" data-reveal>
          <div className="disclaimer-icon"><CircleAlert aria-hidden="true" /></div>
          <div className="disclaimer-copy">
            <p>VexaLens is an educational and research-oriented digital media forensics project. Its tools support structured examination and documentation of digital evidence.</p>
              <p>Available workflows include supported image, video, audio, document, metadata, and signature analysis features. Capabilities depend on the selected tool, file, and configured services.</p>
            <h3>Important Notice:</h3>
            <ul>
              {disclaimerPoints.map(({ label, text }) => (
                <li key={label}><strong>{label}</strong> {text}</li>
              ))}
            </ul>
            <p>By using VexaLens, users acknowledge that its results are intended to support investigation and learning, not to establish definitive conclusions without independent verification.</p>
            <p>Developed for educational purposes, cybersecurity research, and responsible digital forensics.</p>
          </div>
        </div>
      </section>

      <section className="info-closing" aria-labelledby="closing-title" data-reveal>
        <p className="info-eyebrow">THE LENS REVEALS WHAT THE EYE MISSES</p>
        <h2 id="closing-title">Look closer. <em>Stay curious.</em></h2>
        <div className="info-hero-actions">
          <button type="button" className="info-button info-button-primary" onClick={onOpenWorkspace}>
            Enter Forensic Laboratory <ArrowRight aria-hidden="true" />
          </button>
          <a className="info-button info-button-secondary" href="#analysis">
            Explore Investigation Tools <ArrowDown aria-hidden="true" />
          </a>
        </div>
      </section>

      <footer className="info-footer">
        <div className="info-footer-brand">
          <button className="info-brand" type="button" onClick={onHome}>
            <span className="info-brand-mark"><BrandLogo className="h-full w-full rounded-lg object-cover" /></span>
            <span className="info-brand-copy"><strong>VexaLens</strong><small>Look deeper. Question everything.</small></span>
          </button>
          <p>A digital forensics workspace for careful examination, understandable findings, and responsible investigation.</p>
          <span className="footer-tagline">Investigate responsibly. Interpret carefully.</span>
        </div>
        <nav className="info-footer-nav" aria-label="Information sections">
          <h2>Explore</h2>
          {sectionLinks.map((link) => <a href={link.href} key={link.href}>{link.label}</a>)}
        </nav>
        <nav className="info-footer-nav" aria-label="Application navigation">
          <h2>Application</h2>
          <button type="button" onClick={onHome}>Home</button>
          <a href="#information-page">About</a>
          <button type="button" onClick={onOpenWorkspace}>Workspace</button>
          <button type="button" onClick={onOpenPrivacy}>Privacy &amp; Sharing</button>
        </nav>
        <div className="info-footer-bottom">
          <span>© {new Date().getFullYear()} VexaLens</span>
          <span>Digital forensics, approached with care.</span>
        </div>
      </footer>
    </main>
  );
};
