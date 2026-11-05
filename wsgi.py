"""Point d'entrée WSGI (hébergeurs sans ASGI, ex. PythonAnywhere gratuit).

Dans le fichier WSGI de PythonAnywhere :
    import sys; sys.path.insert(0, "/home/<utilisateur>/Lab-Invoicing-main")
    from wsgi import application
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("FACTU_DB", str(ROOT / "data" / "facturation.db"))

from a2wsgi import ASGIMiddleware  # noqa: E402

from app.main import app as asgi_app  # noqa: E402

application = ASGIMiddleware(asgi_app)
