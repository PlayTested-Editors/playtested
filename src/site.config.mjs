export default {
    siteTitle: "PlayTested", // Main site title displayed in header
    siteHomeTitle: "PlayTested | Video Game Reviews & Tech Insights", // Optimized title for homepage search results
    siteSubTitle: "Video Game Reviews, Tech Blog, and AI-powered insights for PC, Console, and Mobile. No-nonsense game reviews that cut through the noise.", // Subtitle shown under main title
    copyright: "© 2025 PlayTested. All Rights Reserved.", // Footer copyright text
    showAuthorsOnHomePage: false, // Display author info on homepage
    showFeaturrdPostsOnHomePage: true, // Show featured posts section on homepage
    showCategoryOnPosts: true, // Display categories on posts in homepage
    postsPerPage: 20,
    labels: {
        featuredPosts: "Featured Posts", // Title for featured posts section
        latestPosts: "Latest Posts", // Title for latest posts section
        viewAllPosts: "View All Posts", // Text for link to paginated blog
        backToHome: "Back to Home", // Back navigation text
        youMightAlsoLike: "You Might Also Like", // Similar posts section title
        postedIn: "Posted in", // Category prefix text in articles
        noArticlesFound: "No articles found.", // Empty state message
        allCategories: "All Categories", // Categories page title
        allTags: "All Tags", // Tags page title
        allAuthors: "All Authors", // Authors page title
        exploreArticlesByTags: "Explore articles organized by topics", // Tags page description
        exploreArticlesByCategories: "Explore articles organized by topics", // Categories page description
        exploreArticlesByAuthors: "Explore articles organized by authors", // Authors page description
        readMore: "Read More", // Text for "Read More" links on featured posts
        shareThisArticle: "Share this article", // Share button text
    },
    pagination: {
        showPrevNext: true, // Show Previous/Next navigation buttons
        prevText: "Previous", // Text for previous page button
        nextText: "Next", // Text for next page button
        postLabel: "posts", // Label used in pagination info (e.g., "8 posts")
    },
    defaultAuthorName: "lyndonguitar",
    showCategoriesLinkOnFooter: true, // Show Categories link in footer
    showTagsLinkOnFooter: true, // Show Tags link in footer
    showAuthorsLinkOnFooter: true, // Show Authors link in footer
    showSimilarPosts: true, // Display similar posts on article pages
    showReadMoreLinkOnFeaturedPosts: true, // Show "Read More" on featured cards
    showThumbnailOnFeaturedPosts: true, // Display thumbnails on featured posts
    numberOfLatestPostsOnHomePage: 18, // Number of latest posts on homepage
    numberOfBlogPostsPerPage: 10, // Number of posts per paginated blog
    numberOfFeaturedPostsOnHomePage: 12,

    gTag: "G-V5QHDKBFP", // Google Analytics tracking ID

    // Ad Configuration
    ads: {
        adSense: {
            enabled: false,
            clientId: import.meta.env.PUBLIC_ADSENSE_CLIENT_ID,
            articleUnitId: import.meta.env.PUBLIC_ADSENSE_ARTICLE_UNIT_ID,
            footerUnitId: import.meta.env.PUBLIC_ADSENSE_FOOTER_UNIT_ID,
        },
        adsterra: {
            enabled: import.meta.env.PUBLIC_ADSTERRA_ENABLED === "true",
            nativeBannerEnabled: true,
            footerBannerEnabled: true,
            socialBarEnabled: false,
            popunderEnabled: false,
            nativeBannerId: import.meta.env.PUBLIC_ADSTERRA_NATIVE_ID, // Your Adsterra Native Banner ID
            footerBannerId: import.meta.env.PUBLIC_ADSTERRA_FOOTER_ID, // Your Adsterra Standard Banner ID
            socialBarId: import.meta.env.PUBLIC_ADSTERRA_SOCIAL_ID, // Your Adsterra Social Bar ID
            popunderId: import.meta.env.PUBLIC_ADSTERRA_POPUNDER_ID, // Your Adsterra Popunder ID
        },
        carbonAds: {
            enabled: false,
            serve: "XXXXXXX", // Carbon Ads 'serve' ID
            placement: "XXXXXXXX", // Carbon Ads 'placement' ID
        }
    }
}

