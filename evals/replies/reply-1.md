Run these in your terminal from the project directory:

```bash
# 1. Create the virtual environment (in a folder named .venv)
python3 -m venv .venv

# 2. Activate it (zsh on macOS)
source .venv/bin/activate

# 3. Install requests
pip install requests

# 4. Confirm it worked
python -c "import requests; print(requests.__version__)"
```

When you're done, run `deactivate` to leave the environment.

Notes:
- Use `python3` to create the venv if plain `python` isn't found. Check with `python3 --version`.
- Activating changes your prompt to show `(.venv)`. You need to activate it again in each new terminal session.
- To save your dependencies for later, run `pip freeze > requirements.txt`. Someone else can then restore them with `pip install -r requirements.txt`.
- Add `.venv/` to `.gitignore` so the environment isn't committed. This directory isn't a git repo right now, so you can skip that for now.
