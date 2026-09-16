"""Setup configuration for NuraVolt package."""

from setuptools import setup, find_packages

# Read README for long description
try:
    with open("README.md", "r", encoding="utf-8") as fh:
        long_description = fh.read()
except FileNotFoundError:
    long_description = "NuraVolt - Solar Energy Intelligence Platform"

setup(
    name="nuravolt",
    version="0.1.0",
    author="Jeffrey de Jong",
    author_email="jeffrey@mokumtech.io",
    description="Solar energy intelligence platform for soiling detection, fault detection, and digital twin modeling",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/jeffreymokumtech/nuravolt",
    packages=find_packages(),
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Science/Research",
        "Topic :: Scientific/Engineering :: Artificial Intelligence",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
    ],
    python_requires=">=3.9",
    install_requires=[
        # Data processing
        "polars>=0.19.0",
        "pandas>=2.0.0",
        "numpy>=1.24.0",

        # Solar physics
        "pvlib>=0.10.0",

        # Machine learning
        "lightgbm>=4.0.0",
        "scikit-learn>=1.3.0",

        # Visualization
        "plotly>=5.17.0",
        "matplotlib>=3.7.0",
        "seaborn>=0.12.0",

        # External data APIs
        "requests>=2.31.0",
        "certifi>=2023.0.0",

        # Utilities
        "python-dateutil>=2.8.0",
    ],
    extras_require={
        "dev": [
            "pytest>=7.4.0",
            "pytest-cov>=4.1.0",
            "black>=23.7.0",
            "isort>=5.12.0",
            "flake8>=6.1.0",
            "mypy>=1.5.0",
        ],
        "notebook": [
            "jupyter>=1.0.0",
            "jupyterlab>=4.0.0",
            "ipywidgets>=8.1.0",
            "nbformat>=5.9.0",
        ],
    },
    entry_points={
        "console_scripts": [
            "nuravolt=nuravolt.cli:main",
        ],
    },
)
