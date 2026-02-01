import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import React from "react";

// Test utilities for wrapping components
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

interface WrapperProps {
  children: React.ReactNode;
}

export function createWrapper() {
  const queryClient = createTestQueryClient();
  
  return function Wrapper({ children }: WrapperProps) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(BrowserRouter, null, children)
    );
  };
}

// Example test to verify setup works
describe("Test Setup", () => {
  it("should pass basic test", () => {
    expect(true).toBe(true);
  });

  it("should have access to DOM matchers", () => {
    const div = document.createElement("div");
    div.textContent = "Hello World";
    document.body.appendChild(div);
    
    expect(div).toBeInTheDocument();
    expect(div).toHaveTextContent("Hello World");
    
    document.body.removeChild(div);
  });

  it("should mock window APIs correctly", () => {
    expect(window.matchMedia).toBeDefined();
    expect(window.ResizeObserver).toBeDefined();
    expect(window.IntersectionObserver).toBeDefined();
  });
});
