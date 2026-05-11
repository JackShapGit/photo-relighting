"""Default text prompts for the polish backend when the user leaves the prompt field empty.

The default prompt is intentionally neutral on lighting/style so img2img at
low denoising strength does not drift away from the classical render's
lighting setup. Quality words only — no stylistic steering.
"""

DEFAULT_PROMPT = (
    "photograph, photorealistic, sharp focus, fine detail, high quality"
)

DEFAULT_NEGATIVE_PROMPT = (
    "lowres, blurry, jpeg artifacts, distorted, deformed, washed out, "
    "oversaturated, cartoon, illustration, painting, render, cgi"
)
