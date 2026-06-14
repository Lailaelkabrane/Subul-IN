# Subul IN

Subul IN is a Chrome extension that integrates artificial intelligence directly into LinkedIn. It is built as part of the Subul platform developed by Smartovate and offers users tools for content generation, profile optimization, network scoring, and conversational assistance through a clean architecture combining a browser extension, a FastAPI backend, and an administration dashboard.

## Overview

The project addresses three recurring problems faced by LinkedIn users: producing engaging content without spending hours writing, understanding how to improve profile visibility, and identifying which professional connections are actually worth pursuing. Subul IN brings these capabilities together in a single tool that works natively inside the LinkedIn interface, only activates on explicit user action, and relies on fine tuned language models combined with semantic embeddings to deliver personalized, explainable results.

## Repository structure

This repository contains three main components.

back
The FastAPI backend hosted on Azure App Service. It handles authentication through JWT tokens shared with the Subul platform, orchestrates calls to the fine tuned models on Azure OpenAI, manages the connection scoring logic, runs the LangGraph based agentic workflow for profile analysis, and persists data in Azure Cosmos DB.

exte
The Chrome extension built with Manifest V3. It injects a content script into LinkedIn pages to extract profile and network data on demand, displays the popup interface for post generation, profile optimization, gap analysis, and network scoring, and communicates securely with the backend over HTTPS.

admin dash
The administration dashboard built with Next.js 14. It provides server side rendered views of system usage, including request volume, latency, error rates, token consumption, estimated cost, and user activity.

## Core features

Personalized post generation using a fine tuned GPT 4o mini model trained on a curated dataset of LinkedIn posts, producing content with first person tone, a strong opening hook, and a clear call to action.

Profile optimization and scoring based on a multi criteria grid inspired by LinkedIn's Social Selling Index, with structured recommendations and a prioritized action plan.

Gap analysis comparing a user's profile against a target professional using multilingual semantic embeddings to identify skill and positioning differences.

Network scoring that evaluates potential connections across five interpretable criteria including industry alignment, mutual connections, engagement rate, company relevance, and seniority match, with results adapted to the user's stated networking objective.

Conversational assistant powered by GPT 4o mini with retrieval augmented memory, allowing the user to ask follow up questions and get context aware answers based on their own history within the app.

## Architecture

All data extraction happens client side inside the user's browser session, in line with LinkedIn's terms of use. Extracted data is sent to the backend over HTTPS with a JWT token for authentication. The backend enriches the request with stored context from Cosmos DB, builds the appropriate prompt or feature vector, calls the relevant model or scoring service, persists the result with a time to live policy, and returns the response to be rendered in the extension popup.

## Technology stack

Backend: FastAPI, Uvicorn, httpx, Azure OpenAI, Azure Cosmos DB, LangGraph
Extension: JavaScript, Chrome Extension Manifest V3
Admin dashboard: Next.js 14, React
Models: fine tuned GPT 4o mini for post generation and profile optimization, paraphrase multilingual MiniLM L12 v2 for semantic embeddings
Authentication: JWT with HS256, shared with the Subul platform

## Status

This project was developed as part of a final year academic project at Smartovate. It has been validated through a pilot phase with measured improvements in content creation time and profile quality scores. Planned next steps include multilingual expansion, migration of the network scorer to a supervised model trained on real interaction data, and broader LangGraph orchestration across all features.

## Environment configuration

The backend and extension rely on environment variables for API keys, database connection strings, and deployment identifiers. These values are not included in this repository and must be configured separately for each environment.
