import { useEffect, useState } from "react";
import { getLabelContent } from "../content/labelContent.js";
import { buildLabelModel } from "../lib/labelSelectors.js";

export function useLabelData() {
  const [state, setState] = useState({
    status: "loading",
    model: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    getLabelContent()
      .then((content) => {
        if (cancelled) {
          return;
        }

        setState({
          status: "ready",
          model: buildLabelModel(content),
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setState({
          status: "error",
          model: null,
          error,
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
