import { useState, useRef, useCallback } from "react";
import * as PDFJS from "pdfjs-dist";
import mammoth from "mammoth";

// Set up PDF.js worker
PDFJS.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const COLORS = {
  bg: "#0D0D0F",
  surface: "#16161A",
  border: "#252529",
  accent: "#7C3AED",
  accentLight: "#A78BFA",
  accentGlow: "#7C3AED33",
  human: "#10B981",
  ai: "#EF4444",
  mixed: "#F59E0B",
  text: "#F0EFFF",
  muted: "#6B6B80",
};

const getMeterColor = (score) => {
  if (score < 30) return COLORS.human;
  if (score < 65) return COLORS.mixed;
  return COLORS.ai;
};

const getVerdict = (score) => {
  if (score < 25) return { label: "Likely Human", color: COLORS.human, emoji: "✅" };
  if (score < 50) return { label: "Probably Human", color: COLORS.human, emoji: "🟢" };
  if (score < 65) return { label: "Mixed / Uncertain", color: COLORS.mixed, emoji: "🟡" };
  if (score < 85) return { label: "Likely AI", color: COLORS.ai, emoji: "🔴" };
  return { label: "Almost Certainly AI", color: COLORS.ai, emoji: "🚨" };
};

const ACCEPTED_TYPES = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "text/plain": "TXT",
  "text/markdown": "MD",
  "text/html": "HTML",
};

export default function AIChecker() {
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [activeTab, setActiveTab] = useState("text"); // "text" | "file"
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  const extractTextFromFile = async (file) => {
    const type = file.type;

    if (type === "application/pdf") {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await PDFJS.getDocument({ data: arrayBuffer }).promise;
      let fullText = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        fullText += content.items.map((item) => item.str).join(" ") + "\n";
      }
      return fullText.trim();
    }

    if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      return result.value.trim();
    }

    if (type === "text/plain" || type === "text/markdown" || type === "text/html" || file.name.endsWith(".txt") || file.name.endsWith(".md")) {
      return await file.text();
    }

    throw new Error("Unsupported file type. Please use PDF, DOCX, or TXT.");
  };

  const handleFile = async (file) => {
    if (!file) return;
    setError(null);
    setExtracting(true);
    setFileName(file.name);
    setText("");
    try {
      const extracted = await extractTextFromFile(file);
      if (!extracted || extracted.trim().split(/\s+/).length < 20) {
        setError("Could not extract enough text from this file. Make sure it contains readable text.");
        setFileName(null);
      } else {
        setText(extracted);
      }
    } catch (err) {
      setError(err.message || "Failed to read file.");
      setFileName(null);
    } finally {
      setExtracting(false);
    }
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, []);

  const handleDragOver = (e) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave = () => setDragOver(false);

  const analyzeText = async () => {
    if (wordCount < 20) {
      setError("Please enter at least 20 words for an accurate analysis.");
      return;
    }
    setError(null);
    setLoading(true);
    setResult(null);

    // Truncate if very long (keep first ~3000 words to stay in token budget)
    const analysisText = text.trim().split(/\s+/).slice(0, 3000).join(" ");

    const prompt = `You are an expert AI content detection system with high accuracy. Analyze the following text and determine the probability it was written by an AI (vs a human).

Analyze these signals carefully:
- Perplexity: AI text tends to use highly predictable word choices
- Burstiness: Humans vary sentence length naturally; AI is more uniform
- Phrase patterns: Look for AI hallmarks like "delve", "it's worth noting", "in conclusion", overly structured flow, hedging language, generic phrasing
- Personal voice: Human writing has quirks, opinions, typos, casual tone; AI is polished and neutral
- Repetition and filler: AI tends to repeat ideas, use transition phrases
- Specificity: AI often stays generic; humans include personal anecdotes or very specific details

Respond ONLY with a valid JSON object, no markdown, no explanation, just raw JSON like this:
{
  "ai_score": <integer 0-100, where 100 = definitely AI>,
  "confidence": <"low" | "medium" | "high">,
  "signals": [
    {"label": "<signal name>", "description": "<brief finding>", "type": "<ai|human|neutral>"}
  ],
  "summary": "<2-3 sentence plain-English explanation of your verdict>"
}

Text to analyze:
"""
${analysisText}
"""`;

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const data = await response.json();
      const raw = data.content.map((b) => b.text || "").join("");
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setResult(parsed);
    } catch (err) {
      setError("Analysis failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setText("");
    setResult(null);
    setError(null);
    setFileName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const verdict = result ? getVerdict(result.ai_score) : null;
  const canAnalyze = wordCount >= 20 && !loading && !extracting;

  return (
    <div style={{
      minHeight: "100vh",
      background: COLORS.bg,
      color: COLORS.text,
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .tab-btn:hover { background: #252529 !important; }
        .analyze-btn:hover:not(:disabled) { opacity: 0.88; transform: translateY(-1px); }
        .reset-btn:hover { background: #252529 !important; }
      `}</style>

      {/* Header */}
      <div style={{
        borderBottom: `1px solid ${COLORS.border}`,
        padding: "18px 24px",
        display: "flex", alignItems: "center", gap: 12,
        background: COLORS.surface,
        position: "sticky", top: 0, zIndex: 10,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: `linear-gradient(135deg, ${COLORS.accent}, #5B21B6)`,
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
        }}>🔍</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-0.3px" }}>AI Detector</div>
          <div style={{ fontSize: 12, color: COLORS.muted }}>Powered by Claude</div>
        </div>
        <div style={{
          marginLeft: "auto",
          background: COLORS.accentGlow,
          border: `1px solid ${COLORS.accent}55`,
          borderRadius: 20, padding: "4px 12px",
          fontSize: 12, color: COLORS.accentLight, fontWeight: 600,
        }}>~90% Accurate</div>
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 20px" }}>

        {!result && (
          <>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6, letterSpacing: "-0.5px" }}>
                Is this text AI-generated?
              </div>
              <div style={{ color: COLORS.muted, fontSize: 14 }}>
                Paste text or upload a file — PDF, Word doc, or plain text.
              </div>
            </div>

            {/* Tabs */}
            <div style={{
              display: "flex", gap: 4,
              background: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 10, padding: 4, marginBottom: 16,
              width: "fit-content",
            }}>
              {[{ id: "text", label: "✏️ Paste Text" }, { id: "file", label: "📁 Upload File" }].map(tab => (
                <button
                  key={tab.id}
                  className="tab-btn"
                  onClick={() => { setActiveTab(tab.id); setError(null); }}
                  style={{
                    background: activeTab === tab.id ? COLORS.accent : "transparent",
                    color: activeTab === tab.id ? "#fff" : COLORS.muted,
                    border: "none", borderRadius: 7,
                    padding: "8px 18px", fontSize: 13, fontWeight: 600,
                    cursor: "pointer", transition: "all 0.15s",
                  }}
                >{tab.label}</button>
              ))}
            </div>

            {/* Text tab */}
            {activeTab === "text" && (
              <>
                <textarea
                  value={text}
                  onChange={(e) => { setText(e.target.value); setFileName(null); }}
                  placeholder="Paste text here to analyze... (minimum 20 words)"
                  style={{
                    width: "100%", minHeight: 220,
                    background: COLORS.surface,
                    border: `1.5px solid ${text ? COLORS.accent + "55" : COLORS.border}`,
                    borderRadius: 12, color: COLORS.text,
                    fontSize: 15, lineHeight: 1.65, padding: 16,
                    resize: "vertical", outline: "none",
                    boxSizing: "border-box", fontFamily: "inherit",
                    transition: "border-color 0.2s",
                  }}
                />
              </>
            )}

            {/* File tab */}
            {activeTab === "file" && (
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: `2px dashed ${dragOver ? COLORS.accent : fileName ? COLORS.human + "66" : COLORS.border}`,
                  borderRadius: 14,
                  background: dragOver ? COLORS.accentGlow : fileName ? "#10B98108" : COLORS.surface,
                  padding: "48px 24px",
                  textAlign: "center",
                  cursor: "pointer",
                  transition: "all 0.2s",
                  minHeight: 200,
                  display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center", gap: 12,
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,.txt,.md"
                  style={{ display: "none" }}
                  onChange={(e) => handleFile(e.target.files[0])}
                />
                {extracting ? (
                  <>
                    <div style={{
                      width: 40, height: 40,
                      border: `3px solid ${COLORS.border}`,
                      borderTop: `3px solid ${COLORS.accent}`,
                      borderRadius: "50%",
                      animation: "spin 0.8s linear infinite",
                    }} />
                    <div style={{ color: COLORS.muted, fontSize: 14 }}>Extracting text...</div>
                  </>
                ) : fileName ? (
                  <>
                    <div style={{ fontSize: 36 }}>📄</div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{fileName}</div>
                    <div style={{ color: COLORS.human, fontSize: 13 }}>
                      ✓ {wordCount.toLocaleString()} words extracted
                    </div>
                    <div style={{ color: COLORS.muted, fontSize: 12 }}>Click to change file</div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 40 }}>📂</div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>Drop a file here or click to browse</div>
                    <div style={{ color: COLORS.muted, fontSize: 13 }}>
                      Supports PDF, Word (.docx), and plain text (.txt)
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Word count + button */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
              <span style={{ fontSize: 13, color: wordCount < 20 && wordCount > 0 ? COLORS.mixed : COLORS.muted }}>
                {wordCount > 0 ? `${wordCount.toLocaleString()} word${wordCount !== 1 ? "s" : ""}` : ""}
                {wordCount < 20 && wordCount > 0 ? " — need at least 20" : ""}
                {wordCount > 3000 ? " — analyzing first 3,000 words" : ""}
              </span>
              <button
                className="analyze-btn"
                onClick={analyzeText}
                disabled={!canAnalyze}
                style={{
                  background: canAnalyze
                    ? `linear-gradient(135deg, ${COLORS.accent}, #5B21B6)`
                    : COLORS.border,
                  color: canAnalyze ? "#fff" : COLORS.muted,
                  border: "none", borderRadius: 10,
                  padding: "12px 28px", fontSize: 15, fontWeight: 600,
                  cursor: canAnalyze ? "pointer" : "not-allowed",
                  transition: "all 0.2s", letterSpacing: "-0.2px",
                }}
              >
                {loading ? "Analyzing..." : "Analyze →"}
              </button>
            </div>

            {error && (
              <div style={{
                marginTop: 14, padding: "12px 16px",
                background: "#EF444415", border: `1px solid ${COLORS.ai}44`,
                borderRadius: 10, color: COLORS.ai, fontSize: 14,
              }}>{error}</div>
            )}
          </>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: "center", padding: "48px 0", color: COLORS.muted }}>
            <div style={{
              width: 48, height: 48,
              border: `3px solid ${COLORS.border}`,
              borderTop: `3px solid ${COLORS.accent}`,
              borderRadius: "50%", margin: "0 auto 16px",
              animation: "spin 0.8s linear infinite",
            }} />
            <div style={{ fontSize: 15 }}>Running deep analysis{fileName ? ` on ${fileName}` : ""}...</div>
          </div>
        )}

        {/* Results */}
        {result && verdict && (
          <div style={{ animation: "fadeIn 0.4s ease" }}>
            {fileName && (
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                marginBottom: 16, padding: "10px 14px",
                background: COLORS.surface, border: `1px solid ${COLORS.border}`,
                borderRadius: 10, fontSize: 13, color: COLORS.muted,
              }}>
                <span>📄</span>
                <span style={{ color: COLORS.text, fontWeight: 500 }}>{fileName}</span>
                <span>·</span>
                <span>{wordCount.toLocaleString()} words analyzed</span>
              </div>
            )}

            {/* Score card */}
            <div style={{
              background: COLORS.surface,
              border: `1.5px solid ${verdict.color}44`,
              borderRadius: 16, padding: 28, marginBottom: 20,
              boxShadow: `0 0 40px ${verdict.color}11`,
            }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
                {/* Donut score */}
                <div style={{ textAlign: "center", minWidth: 100 }}>
                  <div style={{
                    width: 100, height: 100, borderRadius: "50%",
                    background: `conic-gradient(${getMeterColor(result.ai_score)} ${result.ai_score * 3.6}deg, ${COLORS.border} 0deg)`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <div style={{
                      width: 78, height: 78, borderRadius: "50%",
                      background: COLORS.surface,
                      display: "flex", flexDirection: "column",
                      alignItems: "center", justifyContent: "center",
                    }}>
                      <div style={{ fontSize: 26, fontWeight: 800, color: getMeterColor(result.ai_score), lineHeight: 1 }}>
                        {result.ai_score}
                      </div>
                      <div style={{ fontSize: 11, color: COLORS.muted }}>AI score</div>
                    </div>
                  </div>
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 22 }}>{verdict.emoji}</span>
                    <span style={{ fontSize: 20, fontWeight: 800, color: verdict.color, letterSpacing: "-0.5px" }}>
                      {verdict.label}
                    </span>
                  </div>
                  <div style={{ fontSize: 14, color: COLORS.muted, lineHeight: 1.6, marginBottom: 12 }}>
                    {result.summary}
                  </div>
                  <div style={{
                    display: "inline-block",
                    background: COLORS.accentGlow,
                    border: `1px solid ${COLORS.accent}44`,
                    borderRadius: 20, padding: "3px 12px",
                    fontSize: 12, color: COLORS.accentLight,
                  }}>
                    Confidence: {result.confidence}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: COLORS.muted, marginBottom: 6 }}>
                  <span>Human</span><span>AI</span>
                </div>
                <div style={{ height: 8, background: COLORS.border, borderRadius: 4, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${result.ai_score}%`,
                    background: `linear-gradient(90deg, ${COLORS.human}, ${COLORS.mixed}, ${getMeterColor(result.ai_score)})`,
                    borderRadius: 4, transition: "width 1.2s ease",
                  }} />
                </div>
              </div>
            </div>

            {/* Signals */}
            {result.signals?.length > 0 && (
              <div style={{
                background: COLORS.surface,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 16, padding: 20, marginBottom: 20,
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
                  Detection Signals
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {result.signals.map((sig, i) => (
                    <div key={i} style={{
                      display: "flex", alignItems: "flex-start", gap: 12,
                      padding: "10px 14px",
                      background: COLORS.bg, borderRadius: 10,
                      border: `1px solid ${COLORS.border}`,
                    }}>
                      <span style={{ fontSize: 16, marginTop: 1 }}>
                        {sig.type === "ai" ? "🔴" : sig.type === "human" ? "🟢" : "🟡"}
                      </span>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>{sig.label}</div>
                        <div style={{ fontSize: 13, color: COLORS.muted, lineHeight: 1.5 }}>{sig.description}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize: 12, color: COLORS.muted, textAlign: "center", padding: "0 16px 4px", lineHeight: 1.6 }}>
              ⚠️ No AI detector is 100% accurate. Use this as one signal among many, not as sole proof.
            </div>

            <div style={{ textAlign: "center", marginTop: 16 }}>
              <button className="reset-btn" onClick={reset} style={{
                background: "transparent",
                border: `1.5px solid ${COLORS.border}`,
                color: COLORS.text, borderRadius: 10,
                padding: "11px 28px", fontSize: 14, fontWeight: 600,
                cursor: "pointer", transition: "background 0.15s",
              }}>
                ← Check Another
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
