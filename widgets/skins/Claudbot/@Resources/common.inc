; ─────────────────────────────────────────────────────────────────────────────
; Claudbot widgets — shared palette and type.
;
; Included by every skin. Edit here to restyle all four at once.
;
; The look: translucent near-black cards, one cool accent, generous line height,
; and colour used only where it carries meaning (a status dot, a price moving,
; a task running late). Everything else is one of three greys.
;
; The post-it deliberately does NOT use this palette — it's meant to look like
; a physical piece of paper sitting on top of the others.
; ─────────────────────────────────────────────────────────────────────────────

[Variables]

; ── surfaces ──
Card=16,17,21,222
CardEdge=255,255,255,20
Divider=255,255,255,16
Hover=255,255,255,14

; ── ink ──
Ink=234,236,243
InkDim=140,146,163
InkFaint=96,101,116

; ── meaning ──
Accent=96,170,255
Good=92,201,140
Bad=235,102,110
Warn=232,168,80
Idle=110,116,132

; ── type ──
Face=Segoe UI
FaceNum=Consolas
SizeTitle=11
SizeBody=10
SizeSmall=8
SizeBig=15

; ── metrics ──
Pad=14
Radius=10
