import { createRoot } from "react-dom/client"

import Popup from "../../src/Popup"
import { initializeLanguage } from "../../src/i18n"

const container = document.getElementById("root")

if (!container) {
  throw new Error("Popup root element is missing.")
}

void initializeLanguage().then(() => createRoot(container).render(<Popup />))
