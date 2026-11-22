declare module "*.html?raw" {
  const content: string;
  export default content;
}

declare module "*.svg" {
  const url: string;
  export default url;
}
