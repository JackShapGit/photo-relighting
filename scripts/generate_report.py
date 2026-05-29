"""Generate a PDF report of the photo-relighting application overview."""

from fpdf import FPDF
from datetime import date


class Report(FPDF):
    def header(self):
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(100, 100, 100)
        self.cell(0, 8, "Photo Relighting - Application Report", align="L")
        self.cell(0, 8, date.today().strftime("%B %d, %Y"), align="R", new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(200, 200, 200)
        self.line(10, self.get_y(), 200, self.get_y())
        self.ln(4)

    def footer(self):
        self.set_y(-15)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(150, 150, 150)
        self.cell(0, 10, f"Page {self.page_no()}/{{nb}}", align="C")

    def section_title(self, title):
        self.set_font("Helvetica", "B", 14)
        self.set_text_color(30, 60, 120)
        self.ln(4)
        self.cell(0, 10, title, new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(30, 60, 120)
        self.line(10, self.get_y(), 90, self.get_y())
        self.ln(3)

    def subsection_title(self, title):
        self.set_font("Helvetica", "B", 11)
        self.set_text_color(60, 60, 60)
        self.ln(2)
        self.cell(0, 7, title, new_x="LMARGIN", new_y="NEXT")
        self.ln(1)

    def body_text(self, text):
        self.set_font("Helvetica", "", 10)
        self.set_text_color(40, 40, 40)
        self.multi_cell(0, 5.5, text)
        self.ln(1)

    def add_table(self, headers, rows, col_widths=None):
        if col_widths is None:
            col_widths = [190 / len(headers)] * len(headers)

        # Header row
        self.set_font("Helvetica", "B", 9)
        self.set_fill_color(30, 60, 120)
        self.set_text_color(255, 255, 255)
        for i, h in enumerate(headers):
            self.cell(col_widths[i], 7, h, border=1, fill=True, align="C")
        self.ln()

        # Data rows
        self.set_font("Helvetica", "", 9)
        self.set_text_color(40, 40, 40)
        for row_idx, row in enumerate(rows):
            if row_idx % 2 == 0:
                self.set_fill_color(240, 245, 255)
            else:
                self.set_fill_color(255, 255, 255)

            is_total = row[0].upper().startswith("TOTAL")
            if is_total:
                self.set_font("Helvetica", "B", 9)
                self.set_fill_color(220, 230, 245)

            for i, cell in enumerate(row):
                align = "L" if i == 0 else "R"
                self.cell(col_widths[i], 6.5, cell, border=1, fill=True, align=align)
            self.ln()

            if is_total:
                self.set_font("Helvetica", "", 9)
        self.ln(2)

    def bullet(self, text):
        self.set_font("Helvetica", "", 10)
        self.set_text_color(40, 40, 40)
        old_l_margin = self.l_margin
        self.set_left_margin(22)
        self.set_x(14)
        self.multi_cell(0, 5.5, "-  " + text)
        self.set_left_margin(old_l_margin)
        self.ln(0.5)

    def dep_item(self, name, version, purpose):
        self.set_font("Helvetica", "B", 9)
        self.set_text_color(40, 40, 40)
        self.cell(50, 5.5, f"  {name}")
        self.set_font("Helvetica", "", 9)
        self.set_text_color(100, 100, 100)
        self.cell(25, 5.5, version)
        self.set_text_color(40, 40, 40)
        self.cell(0, 5.5, purpose, new_x="LMARGIN", new_y="NEXT")


def build():
    pdf = Report()
    pdf.alias_nb_pages()
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.add_page()

    # ── Title ──
    pdf.set_font("Helvetica", "B", 22)
    pdf.set_text_color(20, 45, 100)
    pdf.cell(0, 12, "Photo Relighting", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 13)
    pdf.set_text_color(80, 80, 80)
    pdf.cell(0, 8, "Application Overview & Dependency Report", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(6)

    # ── 1. Overview ──
    pdf.section_title("1. Application Overview")
    pdf.body_text(
        "Photo Relighting is a controllable, depth-based photo relighting application. "
        "Users upload a photograph and the backend runs ML models to estimate depth, surface "
        "normals, and a subject mask. The browser then provides a real-time WebGL preview "
        "where up to 8 virtual studio lights can be positioned interactively. Final renders "
        "are exported at full resolution and bit-depth via the Python backend."
    )
    pdf.body_text(
        "The application follows a clean three-layer architecture: a pure Python engine "
        "library (relighting_engine), a FastAPI HTTP service (relighting_api), and a "
        "standalone vanilla JavaScript frontend with custom WebGL 2.0 shaders."
    )

    # ── 2. Tech Stack ──
    pdf.section_title("2. Technology Stack")
    pdf.add_table(
        ["Layer", "Technology"],
        [
            ["Backend Framework", "FastAPI 0.110+ / Uvicorn 0.29+"],
            ["Language", "Python 3.11 (locked range)"],
            ["ML / GPU", "PyTorch (CUDA 12.x), torchvision"],
            ["Depth Estimation", "Depth-Anything-V3 (ByteDance)"],
            ["Subject Segmentation", "RMBG-2.0 (BRIA AI), SAM2 (Meta)"],
            ["Diffusion Polish", "Stable Diffusion XL via diffusers"],
            ["Frontend Rendering", "WebGL 2.0 (custom GLSL shaders)"],
            ["3D Visualization", "Three.js (light gizmos, point cloud)"],
            ["Frontend Language", "Vanilla JavaScript (ES6 modules)"],
            ["Database", "SQLite"],
            ["Testing", "pytest, Playwright (WebGL parity)"],
            ["Deployment", "Cloudflare Tunnel + Basic Auth"],
        ],
        col_widths=[55, 135],
    )

    # ── 3. Lines of Code ──
    pdf.section_title("3. Codebase Metrics")
    pdf.add_table(
        ["File Type", "Files", "Lines of Code"],
        [
            ["Python (.py)", "86", "5,767"],
            ["JavaScript (.js)", "26", "4,398"],
            ["CSS (.css)", "1", "905"],
            ["GLSL Shaders (.frag/.vert)", "2", "291"],
            ["HTML (.html)", "1", "103"],
            ["Scripts (.bat/.ps1)", "5", "53"],
            ["Total", "121", "11,517"],
        ],
        col_widths=[80, 40, 70],
    )

    pdf.add_table(
        ["Category", "Lines"],
        [
            ["Application Source", "9,197"],
            ["Test Code", "2,267"],
            ["Total", "11,517"],
        ],
        col_widths=[100, 90],
    )

    # ── 4. Dependencies ──
    pdf.section_title("4. Python Dependencies - Engine")

    pdf.subsection_title("Core / Image Processing")
    pdf.dep_item("numpy", ">=1.26", "Array computation")
    pdf.dep_item("opencv-python-headless", ">=4.9", "Image processing")
    pdf.dep_item("pillow", ">=10.2", "Image I/O (JPEG, PNG)")
    pdf.dep_item("pillow-heif", ">=0.18", "HEIF/HEIC image support")
    pdf.dep_item("imageio[tifffile]", ">=2.34", "TIFF I/O with 16/32-bit support")
    pdf.dep_item("scipy", ">=1.12", "Signal processing, filtering")
    pdf.dep_item("einops", ">=0.7", "Tensor rearrangement")
    pdf.ln(2)

    pdf.subsection_title("Machine Learning / Models")
    pdf.dep_item("torch", "(CUDA 12.x)", "Deep learning framework (GPU)")
    pdf.dep_item("torchvision", "(CUDA 12.x)", "Vision transforms and utilities")
    pdf.dep_item("transformers", ">=4.41", "Hugging Face model loading")
    pdf.dep_item("huggingface_hub", ">=0.23", "Model download and caching")
    pdf.dep_item("depth-anything-3", "git pin", "Monocular depth estimation (ByteDance)")
    pdf.dep_item("kornia", ">=0.7", "Differentiable CV (used by RMBG-2.0)")
    pdf.dep_item("timm", ">=0.9", "Vision model backbones (used by RMBG-2.0)")
    pdf.dep_item("addict", ">=2.4", "Transitive dep of depth-anything-3")
    pdf.ln(2)

    pdf.subsection_title("Optional - Diffusion Polish")
    pdf.dep_item("diffusers", ">=0.27,<1.0", "Stable Diffusion XL pipeline")
    pdf.dep_item("accelerate", ">=0.30", "Model offloading and mixed precision")
    pdf.dep_item("safetensors", ">=0.4", "Safe model weight serialization")
    pdf.ln(2)

    pdf.subsection_title("Optional - Testing")
    pdf.dep_item("pytest", ">=8", "Test runner")
    pdf.dep_item("pytest-asyncio", ">=0.23", "Async test support")
    pdf.dep_item("scikit-image", ">=0.22", "Image comparison metrics (SSIM)")
    pdf.ln(3)

    pdf.section_title("5. Python Dependencies - API")
    pdf.dep_item("relighting-engine", "local", "Engine library (see above)")
    pdf.dep_item("fastapi", ">=0.110", "Async web framework")
    pdf.dep_item("uvicorn[standard]", ">=0.29", "ASGI server")
    pdf.dep_item("pydantic", ">=2.7", "Request/response validation")
    pdf.dep_item("python-multipart", ">=0.0.9", "File upload parsing")
    pdf.ln(1)
    pdf.subsection_title("Optional - Testing")
    pdf.dep_item("httpx", ">=0.27", "Async HTTP test client")
    pdf.ln(3)

    pdf.section_title("6. Frontend Dependencies")
    pdf.dep_item("Three.js", "CDN (importmap)", "3D viewport, light gizmos, point cloud")
    pdf.dep_item("@playwright/test", "^1.50.0", "WebGL vs Python parity tests (dev only)")
    pdf.body_text(
        "The frontend has no build system. JavaScript modules are loaded natively via "
        "ES6 imports, and Three.js is pulled from a CDN using an import map in the HTML."
    )

    # ── 5. ML Models ──
    pdf.section_title("7. ML Models Used")
    pdf.add_table(
        ["Model", "Provider", "Purpose", "Size"],
        [
            ["Depth-Anything-V3", "ByteDance", "Monocular depth estimation", "~370 MB"],
            ["RMBG-2.0", "BRIA AI", "Subject segmentation / bg removal", "~175 MB"],
            ["SAM2", "Meta", "Interactive mask refinement", "~150 MB"],
            ["SDXL (IC-Light)", "Stability AI", "Diffusion polish (optional)", "~6.5 GB"],
        ],
        col_widths=[45, 35, 65, 45],
    )
    pdf.body_text(
        "Models are downloaded on first use and cached locally. RMBG-2.0 weights are "
        "gated on Hugging Face and require license acceptance before download."
    )

    # ── 6. API Routes ──
    pdf.section_title("8. API Endpoints")
    pdf.add_table(
        ["Method", "Endpoint", "Description"],
        [
            ["GET", "/healthz", "GPU status, model availability, capabilities"],
            ["POST", "/prepare", "Upload image, run depth/normals/mask pipeline"],
            ["POST", "/render", "Full-resolution render with light configuration"],
            ["POST", "/polish", "IC-Light diffusion refinement (optional)"],
            ["POST", "/refine_mask", "SAM2 interactive mask editing"],
            ["GET", "/gobos", "List built-in gobo pattern presets"],
            ["GET", "/scenes", "List saved scenes (per workspace)"],
            ["POST", "/scenes", "Create a new scene"],
            ["GET", "/scenes/{id}", "Load a scene"],
            ["PUT", "/scenes/{id}", "Update scene state (auto-save)"],
            ["DELETE", "/scenes/{id}", "Delete a scene"],
            ["POST", "/scenes/{id}/export", "Export scene as .relight.zip"],
            ["POST", "/scenes/import", "Import a portable scene archive"],
            ["DELETE", "/session/{id}", "Clean up session cache"],
        ],
        col_widths=[20, 55, 115],
    )

    # ── 7. Key Features ──
    pdf.add_page()
    pdf.section_title("9. Key Features")
    features = [
        "Up to 8 simultaneous lights: directional, point, spot, and reflector types",
        "Real-time WebGL 2.0 preview at 60 fps with custom GLSL fragment shader (282 lines)",
        "Gobo projections (pattern lights) with orthographic, perspective, and equirectangular UV mapping",
        "Gel color filters with Kelvin-to-RGB temperature conversion",
        "Shadow modes: heightfield ray-march and planar silhouette",
        "3D viewport with Three.js point cloud visualization and interactive light gizmos",
        "Per-zone ambient lighting (independent subject vs. background illumination)",
        "SAM2-based interactive mask refinement (click-to-segment)",
        "IC-Light diffusion polish with freeform text prompts",
        "Auto-save with 500 ms debounce to SQLite",
        "Portable scene export/import as .relight.zip archives",
        "Multi-user workspace isolation via URL query parameters",
        "Debug views: depth map, normal map, mask visualization",
        "WebGL-to-Python parity testing via Playwright",
        "Supports JPEG, PNG, TIFF (16/32-bit), HEIF/HEIC, and WebP input",
        "Cloudflare Tunnel deployment with shared-password Basic Auth",
    ]
    for f in features:
        pdf.bullet(f)

    pdf.add_page()
    # ── 8. Database ──
    pdf.section_title("10. Database Schema")
    pdf.body_text(
        "SQLite database (cache/scenes.db) with a single 'scenes' table:"
    )
    pdf.set_font("Courier", "", 8.5)
    schema = (
        "CREATE TABLE scenes (\n"
        "    id            TEXT PRIMARY KEY,      -- UUID hex\n"
        "    name          TEXT NOT NULL,          -- editable scene name\n"
        "    created_at    TEXT NOT NULL,          -- ISO 8601 UTC\n"
        "    updated_at    TEXT NOT NULL,\n"
        "    session_id    TEXT NOT NULL,          -- -> cache/sessions/{id}\n"
        "    state_json    TEXT NOT NULL,          -- full lighting state\n"
        "    workspace_id  TEXT NOT NULL DEFAULT 'default'\n"
        ");"
    )
    pdf.multi_cell(0, 4.5, schema)
    pdf.ln(2)
    pdf.set_font("Helvetica", "", 10)
    pdf.body_text(
        "Indexes on: updated_at (DESC), name, session_id, and workspace_id. "
        "The state_json column stores the complete lighting tree, ambient settings, "
        "shadow style, debug view mode, and UI selection state."
    )

    # ── 9. Project Info ──
    pdf.section_title("11. Project Information")
    pdf.add_table(
        ["Property", "Value"],
        [
            ["Version", "0.1.0"],
            ["Python Version", "3.11 (locked)"],
            ["Platform", "Windows + CUDA 12.x"],
            ["Build System", "setuptools (backend), no build (frontend)"],
            ["Repository Branch", "feat/3d-viewport"],
            ["License (RMBG-2.0)", "Gated - requires HF license acceptance"],
        ],
        col_widths=[60, 130],
    )

    # ── Save ──
    out = "photo_relighting_report.pdf"
    pdf.output(out)
    print(f"Saved: {out}")


if __name__ == "__main__":
    build()
