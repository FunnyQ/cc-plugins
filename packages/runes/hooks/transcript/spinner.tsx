import type { ClientModule } from "claude-code";

const FRAMES = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];
const TICK_MS = 80;

// a surface module: it turns on the drawing thread's own frame clock, so a hooks module busy with Claude's work
// never holds a frame back
const Spinner: ClientModule<{ color: string }, number> = (props, surface) => {
  if (surface.state === undefined) {
    let frame = 0;
    surface.every(TICK_MS, () => {
      frame = (frame + 1) % FRAMES.length;
      surface.setState(frame);
    });
    surface.setState(0);
  }
  const { Text } = surface.elements;
  return <Text color={props.color}>{`${FRAMES[surface.state ?? 0]} `}</Text>;
};

export default Spinner;
